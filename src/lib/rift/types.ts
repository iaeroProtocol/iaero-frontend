// src/lib/rift/types.ts
//
// Shapes of the Rift router API (https://api.rift.trade, docs: rift.trade/docs) as this app uses them,
// plus the order record we keep in localStorage. Only fields we read are typed.

export type RiftOrderStatus =
  | 'awaiting_deposit'
  | 'funded'
  | 'underfunded'
  | 'expired'
  | 'executing'
  | 'delivered'
  | 'refunded'
  | 'frozen';

export interface RiftRouteStep {
  venue: string;
  execution?: { mode: string; chain?: number };
  from: string;
  to: string;
  step_amount_in: string;
  step_amount_out: string;
}

export interface RiftQuote {
  id: string;
  from: string;
  to: string;
  from_amount: string;
  estimated_amount_out: string;
  expires_at: string;
  route: RiftRouteStep[];
  delivery?: { amount_in: string; amount_out: string; execution_cost: string };
}

export interface RiftOrder {
  id: string;
  quote_id: string;
  from: string;
  to: string;
  from_amount: string;
  deposit_address: string;
  deposit_deadline: string;
  to_address: string;
  refund_address: string | null;
  status: RiftOrderStatus;
  amount_out: string | null;
  created_at: string;
}

export type SourceChainKey = 'ethereum' | 'arbitrum' | 'base' | 'bitcoin';

export interface SourceToken {
  chain: SourceChainKey;
  symbol: string;
  name: string;
  decimals: number;
  /** ERC-20 contract; undefined for the chain's native coin. */
  address?: `0x${string}`;
  /** Rift asset id: `<chain>.<ticker>` for native coins, `<chain>.<0xaddress>` for ERC-20s. */
  asset: string;
  custom?: boolean;
}

/** One order as this browser remembers it, so tracking survives a refresh or a closed tab. */
export interface StoredOrder {
  id: string;
  quoteId: string;
  createdAt: number;
  sourceChain: SourceChainKey;
  token: { symbol: string; decimals: number; address?: string; asset: string };
  fromAmount: string;
  fromAmountRaw: string;
  estimatedOut: string;
  route: RiftRouteStep[];
  depositAddress: string;
  depositDeadline: string;
  toAddress: string;
  refundAddress?: string | null;
  /** EVM payment from this app. */
  depositTxHash?: string;
  depositSentAt?: number;
  depositConfirmedAt?: number;
  depositFailed?: boolean;
  /** Bitcoin payment, observed on mempool.space. */
  btc?: { txid?: string; confirmations?: number; firstSeenAt?: number };
  status: RiftOrderStatus;
  /** First time this browser saw each status. */
  statusTimes: Partial<Record<RiftOrderStatus, number>>;
  amountOut?: string | null;
  deliveryTxHash?: string;
  /** Base block at order creation: where the delivery scan starts. */
  baseFromBlock?: string;
  notify?: boolean;
  /** USD value of the payment and the iAERO price when the order was made (market prices), for the
   *  all-in cost once delivered. */
  usdIn?: number;
  iaeroUsd?: number;
}
