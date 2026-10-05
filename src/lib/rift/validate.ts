// src/lib/rift/validate.ts
//
// Checks every Rift response before the app acts on it, and above all before the wallet is asked to send
// money: the order must deliver iAERO, to the connected wallet, for exactly the amount the user chose.
// Pure functions with type-only imports, so `node --test` can run them (tests/rift/).

import type { RiftOrder, RiftOrderStatus, RiftQuote, RiftRouteStep } from './types';

export const ORDER_STATUSES: readonly RiftOrderStatus[] = [
  'awaiting_deposit', 'funded', 'underfunded', 'expired', 'executing', 'delivered', 'refunded', 'frozen',
];
export const TERMINAL_STATUSES: readonly RiftOrderStatus[] = ['delivered', 'refunded', 'expired', 'frozen'];
export const isTerminal = (s: RiftOrderStatus) => TERMINAL_STATUSES.includes(s);

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/** Source assets this version pays with: native coins, HyperCore spot tokens, ERC-20 contract addresses. */
export const SOURCE_ASSET_RE = /^(ethereum\.eth|arbitrum\.eth|base\.eth|bitcoin\.btc|hyperliquid\.(hype|usdc|btc|eth)|(ethereum|arbitrum|base)\.0x[0-9a-fA-F]{40})$/;
export const AMOUNT_RE = /^(?=.*[1-9])\d{1,24}(\.\d{1,18})?$/;
export const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** The destination must be the actual iAERO contract: by address, or by a name known to stand for that address
 *  (`names`: Rift's published list, and names learned from Rift's raw answers, names.ts). A ticker alone is not
 *  proof of the contract. */
export const isIaeroOnBase = (asset: string, destination: string, names: Readonly<Record<string, string>> = {}) => {
  const a = asset.toLowerCase(), d = destination.toLowerCase();
  return a === d || (chainOf(a) === 'base' && chainOf(d) === 'base' && names[a] === d.slice(d.indexOf('.') + 1));
};

const obj = (v: unknown, what: string): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`Rift returned an invalid ${what}`);
  return v as Record<string, unknown>;
};
const str = (o: Record<string, unknown>, key: string, what: string): string => {
  const v = o[key];
  if (typeof v !== 'string' || v.length === 0) throw new Error(`Rift ${what} is missing ${key}`);
  return v;
};

/** `base.0xabc` -> `base`; Rift asset and address ids are `<chain>.<id>`. */
export const chainOf = (id: string) => (id.includes('.') ? id.slice(0, id.indexOf('.')).toLowerCase() : '');
/** Address strings may come back as `<chain>.<address>`; addresses themselves never contain a dot. */
export const stripChainPrefix = (id: string) => (id.includes('.') ? id.slice(id.lastIndexOf('.') + 1) : id);
const addressOnChain = (id: string, chain: string, field: string) => {
  const prefix = chainOf(id);
  if (id.includes('.') && (id.indexOf('.') !== id.lastIndexOf('.') || !prefix)) throw new Error(`Rift order ${field} has an invalid chain prefix`);
  if (prefix && prefix !== chain) throw new Error(`Rift order ${field} is on a different chain`);
  return stripChainPrefix(id);
};

/** "0.50" -> "0.5", "1." -> "1", "001.20" -> "1.2". Rejects anything that is not a plain decimal. */
export function normalizeDecimal(s: string): string {
  if (!/^\d+(\.\d*)?$/.test(s.trim())) throw new Error(`not a decimal amount: ${s}`);
  let [int, frac = ''] = s.trim().split('.');
  int = int.replace(/^0+(?=\d)/, '');
  frac = frac.replace(/0+$/, '');
  return frac ? `${int}.${frac}` : int;
}

/** Exact decimal -> base units. Refuses more fractional digits than the token has. */
export function decimalToRaw(amount: string, decimals: number): bigint {
  const [int, frac = ''] = normalizeDecimal(amount).split('.');
  if (frac.length > decimals) throw new Error(`amount ${amount} has more than ${decimals} decimals`);
  return BigInt(int) * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

const sameAmount = (a: string, b: string) => normalizeDecimal(a) === normalizeDecimal(b);

/**
 * Whether Rift's `from` is the asset asked for. Rift writes a token on its list by its name (`arbitrum.usdt0`)
 * even when asked by address, and others as `<chain>.<address>`; `names` maps its names to addresses
 * (rift-tokens.ts). An unknown name cannot be verified against the requested contract and is rejected.
 */
export function sameSourceAsset(riftFrom: string, asked: string, names: Readonly<Record<string, string>>): boolean {
  const from = riftFrom.toLowerCase(), want = asked.toLowerCase();
  if (from === want) return true;
  if (chainOf(from) !== chainOf(want)) return false;
  const id = from.slice(from.indexOf('.') + 1), wantId = want.slice(want.indexOf('.') + 1);
  // Another address, a native coin for a token, or anything for a native coin or a HyperCore token.
  if (/^0x[0-9a-f]{40}$/.test(id) || id === 'eth' || !/^0x[0-9a-f]{40}$/.test(wantId)) return false;
  const named = names[from];
  return named === wantId;
}

/** The asset asked for, when the response's `from` should be checked against it. */
export interface SourceCheck { fromAsset: string; names: Readonly<Record<string, string>> }

function parseRoute(v: unknown): RiftRouteStep[] {
  if (!Array.isArray(v) || v.length === 0) throw new Error('Rift quote has no route');
  return v.map((s, i) => {
    const o = obj(s, `route step ${i + 1}`);
    const execution = o.execution && typeof o.execution === 'object' ? (o.execution as RiftRouteStep['execution']) : undefined;
    return {
      venue: str(o, 'venue', 'route step'), execution,
      from: str(o, 'from', 'route step'), to: str(o, 'to', 'route step'),
      step_amount_in: String(o.step_amount_in ?? ''), step_amount_out: String(o.step_amount_out ?? ''),
    };
  });
}

export interface QuoteExpectation { destination: string; fromChain: string; fromAmount: string; source?: SourceCheck }

export function parseQuote(json: unknown, expect: QuoteExpectation): RiftQuote {
  const o = obj(json, 'quote');
  const q: RiftQuote = {
    id: str(o, 'id', 'quote'), from: str(o, 'from', 'quote'), to: str(o, 'to', 'quote'),
    from_amount: str(o, 'from_amount', 'quote'), estimated_amount_out: str(o, 'estimated_amount_out', 'quote'),
    expires_at: str(o, 'expires_at', 'quote'), route: parseRoute(o.route),
    delivery: o.delivery && typeof o.delivery === 'object' ? (o.delivery as RiftQuote['delivery']) : undefined,
  };
  if (!isUuid(q.id)) throw new Error('Rift quote id is not a UUID');
  if (!isIaeroOnBase(q.to, expect.destination, expect.source?.names)) throw new Error('Rift quote does not deliver iAERO');
  if (chainOf(q.from) !== expect.fromChain) throw new Error('Rift quote is for a different source chain');
  if (expect.source && !sameSourceAsset(q.from, expect.source.fromAsset, expect.source.names)) throw new Error('Rift quote is for a different token');
  if (!sameAmount(q.from_amount, expect.fromAmount)) throw new Error('Rift quote is for a different amount');
  // A plain decimal, as an order saves it (order-state.ts): "1.2e-7" or "+61.9" would be dropped when read back.
  if (!/^\d+(\.\d+)?$/.test(q.estimated_amount_out) || !Number.isFinite(Number(q.estimated_amount_out))
    || !(Number(q.estimated_amount_out) > 0)) throw new Error('Rift quote has no output');
  if (Number.isNaN(Date.parse(q.expires_at))) throw new Error('Rift quote has no valid expiry');
  return q;
}

function parseStatus(o: Record<string, unknown>): RiftOrderStatus {
  const s = str(o, 'status', 'order');
  if (!ORDER_STATUSES.includes(s as RiftOrderStatus)) throw new Error(`unknown Rift order status: ${s}`);
  return s as RiftOrderStatus;
}

export interface OrderExpectation {
  destination: string; quoteId: string; toAddress: string; fromChain: string; fromAmount: string;
  refundAddress?: string;
  source?: SourceCheck;
  /** A new order: Rift returns an existing order when a quote is presented twice, which must never be paid again. */
  fresh?: boolean;
}

const sameAddress = (a: string, b: string) => (/^(0x|bc1)/i.test(a) ? a.toLowerCase() === b.toLowerCase() : a === b);

/** Validates a freshly created order. Funds are only sent after this passes. */
export function parseOrder(json: unknown, expect: OrderExpectation): RiftOrder {
  const o = obj(json, 'order');
  const order: RiftOrder = {
    id: str(o, 'id', 'order'), quote_id: str(o, 'quote_id', 'order'), from: str(o, 'from', 'order'),
    to: str(o, 'to', 'order'), from_amount: str(o, 'from_amount', 'order'),
    deposit_address: addressOnChain(str(o, 'deposit_address', 'order'), expect.fromChain, 'deposit address'),
    deposit_deadline: str(o, 'deposit_deadline', 'order'), to_address: addressOnChain(str(o, 'to_address', 'order'), 'base', 'delivery address'),
    refund_address: typeof o.refund_address === 'string' ? addressOnChain(o.refund_address, expect.fromChain, 'refund address') : null,
    status: parseStatus(o), amount_out: typeof o.amount_out === 'string' ? o.amount_out : null,
    created_at: typeof o.created_at === 'string' ? o.created_at : new Date().toISOString(),
  };
  if (!isUuid(order.id)) throw new Error('Rift order id is not a UUID');
  if (order.quote_id !== expect.quoteId) throw new Error('Rift order is for a different quote');
  if (!isIaeroOnBase(order.to, expect.destination, expect.source?.names)) throw new Error('Rift order does not deliver iAERO');
  if (order.to_address.toLowerCase() !== expect.toAddress.toLowerCase()) throw new Error('Rift order delivers to a different wallet');
  if (chainOf(order.from) !== expect.fromChain) throw new Error('Rift order is for a different source chain');
  if (expect.source && !sameSourceAsset(order.from, expect.source.fromAsset, expect.source.names)) throw new Error('Rift order is for a different token');
  if (!sameAmount(order.from_amount, expect.fromAmount)) throw new Error('Rift order is for a different amount');
  if (expect.refundAddress && (!order.refund_address || !sameAddress(order.refund_address, expect.refundAddress))) {
    throw new Error('Rift order does not refund to the address you gave');
  }
  if (expect.fresh && order.status !== 'awaiting_deposit') {
    throw new Error('Rift returned an order that is already under way (this quote was used before); nothing was sent');
  }
  if (Number.isNaN(Date.parse(order.deposit_deadline))) throw new Error('Rift order has no valid deposit deadline');
  return order;
}

/** `status` is null when Rift reports a status this version does not know (`rawStatus` says which). */
export interface OrderUpdate { status: RiftOrderStatus | null; rawStatus: string; amountOut: string | null }

/** Validates a status poll for an order we already hold. */
export function parseOrderUpdate(json: unknown, orderId: string): OrderUpdate {
  const o = obj(json, 'order');
  if (str(o, 'id', 'order') !== orderId) throw new Error('Rift returned a different order');
  const raw = str(o, 'status', 'order');
  return {
    status: ORDER_STATUSES.includes(raw as RiftOrderStatus) ? (raw as RiftOrderStatus) : null,
    rawStatus: raw,
    amountOut: typeof o.amount_out === 'string' ? o.amount_out : null,
  };
}

/** Whether an address's code makes it a contract wallet. An EIP-7702 delegation (0xef0100 + the delegate's
 *  address) is not one: the account is still an EOA, and its key controls the same address on every chain. */
export const isContractCode = (code: string | undefined) =>
  !!code && code !== '0x' && !/^0xef0100[0-9a-fA-F]{40}$/.test(code);
