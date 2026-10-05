// src/lib/rift/quote-check.ts
//
// A Rift quote checked against what was asked (validate.ts), after resolving any token name this browser does
// not know yet (names.ts): one raw quote for the same request says which address the name stands for.

import { fetchQuote, riftBudget, type RiftCallKind } from './client';
import { RIFT_TOKEN_NAMES } from './rift-tokens';
import { learnedNames, namesToLearn, rememberNames, unknownNames } from './names';
import { parseQuote, type QuoteExpectation } from './validate';
import type { RiftQuote } from './types';

/** Every token name this browser can check: Rift's published list, then names learned from its raw answers. */
export function riftNames(): Readonly<Record<string, string>> {
  return { ...learnedNames(), ...RIFT_TOKEN_NAMES };
}

/**
 * A formatted quote, checked. If it names a token this browser does not know, one raw quote for the same
 * request (`rawAmount`: the amount in base units) resolves the name and the check runs again. Background route
 * checks resolve a name only when the call budget allows.
 */
export async function checkQuote(
  json: unknown, expect: Omit<QuoteExpectation, 'source'> & { fromAsset: string },
  resolve: { rawAmount: bigint; kind: RiftCallKind },
): Promise<RiftQuote> {
  const check = () => parseQuote(json, { ...expect, source: { fromAsset: expect.fromAsset, names: riftNames() } });
  try {
    return check();
  } catch (e) {
    if (!unknownNames(json, riftNames()).length || resolve.rawAmount <= 0n) throw e;
    if (resolve.kind !== 'user' && !riftBudget(resolve.kind)) throw e;
    const raw = await fetchQuote(
      { from: expect.fromAsset, from_amount: resolve.rawAmount.toString(), quote_mode: 'fast', format: 'raw' }, undefined, resolve.kind,
    );
    const pairs = namesToLearn(json, raw, { from: expect.fromAsset, to: expect.destination });
    if (!pairs || !Object.keys(pairs).length) throw e;
    rememberNames(pairs);
    return check();
  }
}
