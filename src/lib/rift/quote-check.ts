// src/lib/rift/quote-check.ts
//
// A Rift quote checked against what was asked (validate.ts), after resolving any token name this browser does
// not know yet, or knows for another address (names.ts): one raw quote for the same request says which address
// the name stands for now.

import { fetchQuote, riftBudget, type RiftCallKind } from './client';
import { RIFT_TOKEN_NAMES } from './rift-tokens';
import { learnedNames, mismatchedNames, namesToLearn, rememberNames, unknownNames } from './names';
import { parseQuote, type QuoteExpectation } from './validate';
import type { RiftQuote } from './types';

/** Every token name this browser can check: Rift's published list, overridden by names learned from its raw
 *  answers (newer than the list). */
export function riftNames(): Readonly<Record<string, string>> {
  return { ...RIFT_TOKEN_NAMES, ...learnedNames() };
}

/** Names in an answer that need a raw lookup before it can be checked: unknown, or known for another address. */
export function unresolvedNames(json: unknown, fromAsset: string, destination: string): string[] {
  const names = riftNames();
  return [...unknownNames(json, names), ...mismatchedNames(json, { from: fromAsset, to: destination }, names)];
}

/**
 * A formatted quote, checked. If it names a token this browser does not know (or knows for another address),
 * one raw quote for the same request (`rawAmount`: the amount in base units) resolves the name and the check runs
 * again. Background route checks resolve a name only when the call budget allows.
 */
export async function checkQuote(
  json: unknown, expect: Omit<QuoteExpectation, 'source'> & { fromAsset: string },
  resolve: { rawAmount: bigint; kind: RiftCallKind },
): Promise<RiftQuote> {
  const check = () => parseQuote(json, { ...expect, source: { fromAsset: expect.fromAsset, names: riftNames() } });
  try {
    return check();
  } catch (e) {
    if (!unresolvedNames(json, expect.fromAsset, expect.destination).length || resolve.rawAmount <= 0n) throw e;
    // A route check's name lookup comes straight after its quote, so it is held to the poll limit, not the
    // probes' 15 s spacing (which would never let it go).
    if (resolve.kind !== 'user' && !riftBudget(resolve.kind === 'probe' ? 'poll' : resolve.kind)) throw e;
    const raw = await fetchQuote(
      { from: expect.fromAsset, from_amount: resolve.rawAmount.toString(), quote_mode: 'fast', format: 'raw' }, undefined, resolve.kind,
    );
    if (!raw || typeof raw !== 'object' || (raw as { from_amount?: unknown }).from_amount !== resolve.rawAmount.toString()) throw e;
    const pairs = namesToLearn(json, raw, { from: expect.fromAsset, to: expect.destination });
    if (!pairs || !Object.keys(pairs).length) throw e;
    rememberNames(pairs);
    return check();
  }
}
