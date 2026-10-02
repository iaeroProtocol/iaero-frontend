// src/lib/rift/bitcoin.ts
//
// Bitcoin payments: address checks, a BIP21 payment link, and progress from mempool.space (which allows
// browser requests), so the user sees their payment and its confirmations before Rift reports it.

const BTC_ADDRESS_RE = /^(bc1[02-9ac-hj-np-z]{8,87}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/;
export const isBtcAddress = (a: string) => BTC_ADDRESS_RE.test(a.trim());

/** `bitcoin:<address>?amount=<btc>`: most wallets pre-fill both from a QR code or a tap. */
export const bip21 = (address: string, amountBtc: string) => `bitcoin:${address}?amount=${amountBtc}`;

const MEMPOOL = 'https://mempool.space/api';

interface MempoolTx {
  txid: string;
  status: { confirmed: boolean; block_height?: number };
  vout: { scriptpubkey_address?: string; value: number }[];
}

export interface BtcDeposit { txid: string; confirmations: number; sats: bigint }

/** The first transaction paying `address`, with its confirmation count, or null if none yet. */
export async function findBtcDeposit(address: string, signal?: AbortSignal): Promise<BtcDeposit | null> {
  const res = await fetch(`${MEMPOOL}/address/${address}/txs`, { signal, cache: 'no-store' });
  if (!res.ok) throw new Error(`mempool.space ${res.status}`);
  const txs = (await res.json()) as MempoolTx[];
  const paying = txs
    .map(tx => ({ tx, sats: tx.vout.filter(o => o.scriptpubkey_address === address).reduce((n, o) => n + BigInt(o.value), 0n) }))
    .filter(x => x.sats > 0n);
  if (!paying.length) return null;
  const { tx, sats } = paying[paying.length - 1];
  let confirmations = 0;
  if (tx.status.confirmed && tx.status.block_height) {
    const tip = await fetch(`${MEMPOOL}/blocks/tip/height`, { signal, cache: 'no-store' });
    if (tip.ok) confirmations = Math.max(1, Number(await tip.text()) - tx.status.block_height + 1);
  }
  return { txid: tx.txid, confirmations, sats };
}
