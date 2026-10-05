// src/lib/rift/payment-io.ts
//
// The network side of paying and of checking a payment: reading the deposit address (evidence.ts judges what
// is found) and posting a signed HyperCore transfer. Every call has a timeout.

import { erc20Abi, type Address, type PublicClient } from 'viem';
import { HL_API, exchangeOutcome, spotSendRequest, type ExchangeOutcome } from './hypercore';
import { judgeEvmDeposit, judgeHyperLedger, type Evidence } from './evidence';
import type { StoredOrder } from './types';

const HL_TIMEOUT_MS = 15_000;

/** A POST to Hyperliquid, its body read within the same timeout (a stalled body must not hang a payment). */
async function hlPost(path: '/info' | '/exchange', body: unknown): Promise<{ ok: boolean; status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HL_TIMEOUT_MS);
  try {
    const res = await fetch(`${HL_API}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal,
    });
    return { ok: res.ok, status: res.status, text: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

/** The deposit address on an EVM chain: the paid token's balance, its nonce and its code, at `blockNumber` when
 *  given (to compare with another read at the same block). Throws if the chain cannot be read. */
export async function evmDepositEvidence(
  client: PublicClient, o: Pick<StoredOrder, 'depositAddress' | 'token' | 'fromAmountRaw'>, blockNumber?: bigint,
): Promise<Evidence> {
  const vault = o.depositAddress as Address;
  const at = blockNumber === undefined ? { blockTag: 'latest' as const } : { blockNumber };
  const [balance, nonce, code] = await Promise.all([
    o.token.address
      ? client.readContract({ address: o.token.address as Address, abi: erc20Abi, functionName: 'balanceOf', args: [vault], ...at })
      : client.getBalance({ address: vault, ...at }),
    client.getTransactionCount({ address: vault, ...at }),
    client.getCode({ address: vault, ...at }),
  ]);
  return judgeEvmDeposit({ balance, need: BigInt(o.fromAmountRaw), nonce, code });
}

/** HyperCore ledger entries are read from this long before the order was made: `createdAt` is this computer's
 *  clock, which can run ahead of Hyperliquid's. The deposit address is new for each order, so nothing older can
 *  match it anyway. */
const LEDGER_LOOKBACK_MS = 24 * 3600_000;

/** The payer's HyperCore transfers to the deposit address. Throws if Hyperliquid cannot be read. */
export async function hyperDepositEvidence(o: Pick<StoredOrder, 'toAddress' | 'depositAddress' | 'fromAmount' | 'createdAt'>, symbol: string) {
  const since = o.createdAt - LEDGER_LOOKBACK_MS;
  const res = await hlPost('/info', { type: 'userNonFundingLedgerUpdates', user: o.toAddress, startTime: since });
  if (!res.ok) throw new Error(`Hyperliquid HTTP ${res.status}`);
  return judgeHyperLedger(JSON.parse(res.text), { owner: o.toAddress, deposit: o.depositAddress, symbol, need: Number(o.fromAmount), since });
}

/** Post a signed HyperCore spot transfer. Only a 200 with status "err" is a refusal; anything else that is not
 *  "ok" (a gateway error, a timeout) leaves the outcome unknown. */
export async function postHyperTransfer(a: NonNullable<StoredOrder['hlAction']>): Promise<ExchangeOutcome> {
  let res: Awaited<ReturnType<typeof hlPost>>;
  try {
    res = await hlPost('/exchange', spotSendRequest(a, { r: a.r, s: a.s, v: a.v }));
  } catch {
    return { kind: 'unknown' };
  }
  let json: unknown = null;
  try { json = JSON.parse(res.text); } catch { /* not JSON: unknown */ }
  return exchangeOutcome(res.ok, json);
}

/** A fresh, random address: nothing has ever been sent to it. */
function randomAddress(): Address {
  return `0x${[...crypto.getRandomValues(new Uint8Array(20))].map(b => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Would a transfer of `amount` deliver all of it? Simulated with eth_simulateV1 (nothing is signed or sent) to a
 * fresh address before an order exists, or the actual deposit address immediately before paying:
 * fee-on-transfer and rebasing tokens deliver less, which would leave the order underfunded.
 * 'reverts': the transfer itself would fail now (the balance moved, or the token blocks it); null: it can't be
 * told (the node does not simulate, or did not answer).
 */
export async function transferDeliversInFull(
  client: PublicClient, token: Address, owner: Address, amount: bigint, recipient?: Address,
): Promise<boolean | 'reverts' | null> {
  const probe = recipient ?? randomAddress();
  try {
    const { results } = await client.simulateCalls({
      account: owner,
      calls: [
        { to: token, abi: erc20Abi, functionName: 'balanceOf', args: [probe] },
        { to: token, abi: erc20Abi, functionName: 'transfer', args: [probe, amount] },
        { to: token, abi: erc20Abi, functionName: 'balanceOf', args: [probe] },
      ],
    });
    const [before, sent, after] = results;
    // A token that reports failure by returning false instead of reverting fails all the same.
    if (sent.status !== 'success' || sent.result === false) return 'reverts';
    if (before.status !== 'success' || after.status !== 'success') return null;
    return (after.result as bigint) - (before.result as bigint) >= amount;
  } catch {
    return null;
  }
}

/** The account's nonce: 'pending' counts transactions the node has seen but not mined; a block number reads it
 *  at that block. */
export const accountNonce = (client: PublicClient, address: string, at: 'pending' | 'latest' | bigint) =>
  typeof at === 'bigint'
    ? client.getTransactionCount({ address: address as Address, blockNumber: at })
    : client.getTransactionCount({ address: address as Address, blockTag: at });
