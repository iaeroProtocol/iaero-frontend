// src/lib/rift/bitcoin.ts
//
// Bitcoin payments: address checks with real checksums (a typo in a refund address must not pass), a BIP21
// payment link, and payments to an address from mempool.space (which allows browser requests), so the user
// sees their payment, its confirmations and whether the amount matches before Rift reports it.

import { sha256 } from 'viem';

// --- Addresses: bech32 / bech32m (BIP-173, BIP-350) and base58check (P2PKH "1…", P2SH "3…") ---

const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}

function convertBits(data: number[], from: number, to: number): number[] | null {
  let acc = 0, bits = 0;
  const out: number[] = [], max = (1 << to) - 1;
  for (const v of data) {
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) { bits -= to; out.push((acc >>> bits) & max); }
  }
  if (bits >= from || ((acc << (to - bits)) & max)) return null;
  return out;
}

function isSegwitAddress(address: string): boolean {
  if (address !== address.toLowerCase() && address !== address.toUpperCase()) return false;
  const s = address.toLowerCase();
  const sep = s.lastIndexOf('1');
  if (sep < 1 || sep + 7 > s.length || s.length > 90 || s.slice(0, sep) !== 'bc') return false;
  const data: number[] = [];
  for (const c of s.slice(sep + 1)) { const d = BECH32.indexOf(c); if (d < 0) return false; data.push(d); }
  const hrp = [...'bc'].map(c => c.charCodeAt(0));
  const chk = polymod([...hrp.map(c => c >> 5), 0, ...hrp.map(c => c & 31), ...data]);
  const payload = data.slice(0, -6);
  if (!payload.length) return false;
  const version = payload[0];
  if (version > 16 || chk !== (version === 0 ? 1 : 0x2bc830a3)) return false;
  const program = convertBits(payload.slice(1), 5, 8);
  if (!program || program.length < 2 || program.length > 40) return false;
  // Version 0 (20 or 32 bytes) and taproot (version 1, 32 bytes) only: other programs are valid encodings that
  // anyone can spend today, so a refund sent there could be taken.
  return version === 0 ? program.length === 20 || program.length === 32 : version === 1 && program.length === 32;
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function isBase58Address(address: string): boolean {
  let n = 0n;
  for (const c of address) { const i = BASE58.indexOf(c); if (i < 0) return false; n = n * 58n + BigInt(i); }
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of address) { if (c !== '1') break; bytes.unshift(0); }
  if (bytes.length !== 25 || (bytes[0] !== 0x00 && bytes[0] !== 0x05)) return false;
  const check = sha256(sha256(Uint8Array.from(bytes.slice(0, 21)), 'bytes'), 'bytes');
  return check.slice(0, 4).every((b, i) => b === bytes[21 + i]);
}

/** A valid mainnet Bitcoin address, checksum included. */
export function isBtcAddress(address: string): boolean {
  const a = address.trim();
  if (/^[13]/.test(a)) return a.length >= 26 && a.length <= 35 && isBase58Address(a);
  return /^bc1/i.test(a) && isSegwitAddress(a);
}

/** The form to send on: bech32 addresses lowercased (uppercase is valid but some services reject it). */
export const normalizeBtcAddress = (address: string) => (/^bc1/i.test(address.trim()) ? address.trim().toLowerCase() : address.trim());

/** `bitcoin:<address>?amount=<btc>`: most wallets pre-fill both from a QR code or a tap. */
export const bip21 = (address: string, amountBtc: string) => `bitcoin:${address}?amount=${amountBtc}`;

// --- Payments to an address, from mempool.space ---

const MEMPOOL = 'https://mempool.space/api';
/** For the whole lookup, bodies included: a stalled answer must not stop tracking. */
const MEMPOOL_TIMEOUT_MS = 15_000;

interface MempoolTx {
  txid: string;
  status: { confirmed: boolean; block_height?: number };
  vout: { scriptpubkey_address?: string; value: number }[];
}

export interface BtcPayment { txid: string; sats: bigint; confirmations: number }
export interface BtcDeposits { payments: BtcPayment[]; totalSats: bigint }

/** A look at an order's Bitcoin address, as the order card and the background watcher take it (order-state.ts
 *  btcLookPatch): its payments; or 'known' when it lists none although a payment was recorded, if mempool.space
 *  still knows that transaction (its address index can lag behind its own transactions). Throws when it can't be
 *  read, or can't say. */
export async function lookAtBtcAddress(address: string, recordedTxid?: string): Promise<BtcDeposits | 'known'> {
  const d = await findBtcDeposits(address);
  if (d.payments.length || !recordedTxid) return d;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MEMPOOL_TIMEOUT_MS);
  try {
    const res = await fetch(`${MEMPOOL}/tx/${encodeURIComponent(recordedTxid)}/status`, { signal: controller.signal });
    if (res.status === 404) return d; // gone: dropped, or replaced by a transaction paying elsewhere
    if (!res.ok) throw new Error(`mempool.space ${res.status}`);
    return 'known';
  } finally {
    clearTimeout(timer);
  }
}

/** Every transaction paying `address` (oldest first) with its confirmations, and their total. A bech32 address may
 *  be written in capitals (BIP-173); mempool.space writes it in lower case. */
export async function findBtcDeposits(given: string, signal?: AbortSignal): Promise<BtcDeposits> {
  const address = /^bc1/i.test(given) ? given.toLowerCase() : given;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MEMPOOL_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    const res = await fetch(`${MEMPOOL}/address/${address}/txs`, { signal: controller.signal });
    if (!res.ok) throw new Error(`mempool.space ${res.status}`);
    const txs = (await res.json()) as MempoolTx[];
    const paying = txs
      .map(tx => ({ tx, sats: tx.vout.filter(o => o.scriptpubkey_address === address).reduce((n, o) => n + BigInt(o.value), 0n) }))
      .filter(x => x.sats > 0n)
      .reverse();
    let tip = 0;
    if (paying.some(p => p.tx.status.confirmed)) {
      const r = await fetch(`${MEMPOOL}/blocks/tip/height`, { signal: controller.signal });
      if (r.ok) tip = Number(await r.text()) || 0;
    }
    const payments = paying.map(({ tx, sats }) => ({
      txid: tx.txid, sats,
      // Confirmed is at least one confirmation, even when the tip height can't be read.
      confirmations: !tx.status.confirmed ? 0 : tx.status.block_height && tip ? Math.max(1, tip - tx.status.block_height + 1) : 1,
    }));
    return { payments, totalSats: payments.reduce((n, p) => n + p.sats, 0n) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** "0.00012345" BTC -> satoshis. */
export function btcToSats(btc: string): bigint {
  const [int, frac = ''] = btc.trim().split('.');
  return BigInt(int || '0') * 100_000_000n + BigInt((frac + '00000000').slice(0, 8) || '0');
}
