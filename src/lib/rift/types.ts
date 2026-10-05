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

export type SourceChainKey = 'ethereum' | 'arbitrum' | 'base' | 'bitcoin' | 'hyperliquid';

export interface SourceToken {
  chain: SourceChainKey;
  symbol: string;
  name: string;
  decimals: number;
  /** ERC-20 contract; undefined for the chain's native coin. */
  address?: `0x${string}`;
  /** Rift asset id: `<chain>.<ticker>` for native coins, `<chain>.<0xaddress>` for ERC-20s. */
  asset: string;
  /** HyperCore token as a spot transfer names it ("HYPE:0x0d01..."). */
  hlToken?: string;
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

  // --- Paying (EVM and HyperCore, from this app) ---
  /** Set just before the wallet (or Hyperliquid) is asked, and refreshed every 15 s by the tab waiting on the
   *  wallet: if it goes stale with no result, the outcome is unknown. */
  payRequestedAt?: number;
  /** When the latest payment attempt started (kept after it ends). */
  payAttemptAt?: number;
  /** Unique claim for this attempt. Async wallet results must only update the attempt that started them. */
  payAttemptId?: string;
  /** The paying account's pending nonce just before the latest EVM prompt: a higher one later means something
   *  was sent from the account since. */
  payNonce?: number;
  /** The last attempt may or may not have sent money (lost response, page closed mid-prompt). */
  payUnknown?: boolean;
  /** EVM payment hash (a HyperCore transfer has none: depositSentAt alone marks it). */
  depositTxHash?: string;
  /** Earlier attempts' hashes (failed, cancelled or replaced), newest last. */
  pastTxHashes?: string[];
  /** The payment transaction's nonce once seen on-chain: if the account's nonce passes it without this hash
   *  being mined, the payment was replaced (a speed-up or a cancel), even after a reload. */
  depositNonce?: number;
  depositSentAt?: number;
  depositConfirmedAt?: number;
  /** depositSentAt is an estimate (the payment was found by a check, or seen late), not when it was sent. */
  startEstimated?: boolean;
  /** A failed payment attempt. Legacy `lost` EVM attempts remain unknown until the wallet proves their outcome. */
  depositFailed?: boolean;
  depositFailReason?: 'reverted' | 'cancelled' | 'pre_send' | 'replaced' | 'lost';
  /** Base units that actually reached the deposit address, when less than ordered (fee-on-transfer tokens). */
  depositReceivedRaw?: string;
  /** HyperCore: the signed transfer of the latest attempt. A retry re-posts this same transfer, which
   *  Hyperliquid accepts at most once (its nonce), instead of signing a second one. */
  hlAction?: { destination: string; token: string; amount: string; time: number; r: string; s: string; v: number };
  /** HyperCore: when that signed transfer was first posted. A refusal when it is posted again may only mean the
   *  first post went through, so it is not read as "nothing was sent". */
  hlPostedAt?: number;
  /** The user hid this order once its pay window had closed and a check found no payment. It stays tracked, at
   *  the idle rate, and comes back if Rift reports a payment. */
  hiddenAt?: number;
  /** Bitcoin payments to the deposit address, observed on mempool.space. `missing`: seen before, no longer
   *  found (dropped or replaced); `seenLate`: first seen already confirmed, so firstSeenAt is not the send time. */
  btc?: {
    txid?: string; confirmations?: number; firstSeenAt?: number; totalSats?: string; payments?: number; missing?: boolean; seenLate?: boolean;
    /** Empty answers in a row since the payment was last seen. */
    emptyChecks?: number;
    /** A payment was seen with a confirmation: it is never treated as missing (order-state.ts btcConfirmed). */
    confirmed?: boolean;
  };

  // --- Rift's status ---
  status: RiftOrderStatus;
  /** First time this browser saw each status. */
  statusTimes: Partial<Record<RiftOrderStatus, number>>;
  /** Statuses first seen after a gap of minutes: their time is when the page noticed, not when it happened. */
  statusLate?: Partial<Record<RiftOrderStatus, boolean>>;
  lastPolledAt?: number;
  /** A status this app does not know yet, as Rift wrote it. */
  rawStatus?: string;
  /** The order's terminal status this browser has already notified about. */
  notifiedStatus?: RiftOrderStatus;
  /** Delivered: iAERO amount; refunded: the refunded amount of the paid token. */
  amountOut?: string | null;
  deliveryTxHash?: string;
  /** Block time of the delivery (ms), for an accurate duration. */
  deliveredAtChain?: number;
  /** Base block at order creation: where the delivery scan starts; and how far it has scanned. */
  baseFromBlock?: string;
  deliveryScannedTo?: string;
  notify?: boolean;

  // --- Prices when ordered ---
  /** USD value of the payment and iAERO's pool price when the order was made, for the all-in cost once
   *  delivered. (The first orders stored DeFiLlama's lagging iAERO price as usdIn/iaeroUsd; those fields
   *  are ignored, so those orders show no all-in cost.) */
  marketUsdIn?: number;
  marketIaeroUsd?: number;
  /** What the page told the user to expect: Rift's quote minus its estimated gas-desk charge (cost.ts),
   *  and that charge in USD. Absent on the first orders, which compare against the quote instead. */
  expectedOut?: string;
  gasDeskUsd?: number;
}
