// src/lib/rift/quote-check.ts
//
// A Rift quote checked against what was asked (validate.ts), after resolving any token name this browser does
// not know yet (names.ts): one raw quote for the same request says which address the name stands for. A name
// this browser knows for another address is refused, never re-pointed.

import { fetchQuote, riftBudget, type RiftCallKind } from './client';
import { RIFT_TOKEN_NAMES } from './rift-tokens';
import { guessNames, learnedNames, namesToLearn, rememberNames, unknownNames } from './names';
import { parseQuote, type QuoteExpectation } from './validate';
import type { RiftQuote } from './types';

/** Every token name this browser can check: names learned from Rift's raw answers, and Rift's published list,
 *  which always wins (a learned name can never stand in for a listed token). */
export function riftNames(): Readonly<Record<string, string>> {
  return { ...learnedNames(), ...RIFT_TOKEN_NAMES };
}

/** The answer names a token this browser doesn't know, and the lookup that would resolve it could not run now
 *  (no room in the background call budget): ask again later rather than treating the token as unsupported. */
export class NameLookupPending extends Error {}

/**
 * A formatted quote, checked. If it names a token this browser does not know, one raw quote for the same
 * request (`rawAmount`: the amount in base units) resolves the name and the check runs again. Background route
 * checks resolve a name only when the call budget allows (NameLookupPending otherwise).
 */
export async function checkQuote(
  json: unknown, expect: Omit<QuoteExpectation, 'source'> & { fromAsset: string },
  resolve: { rawAmount: bigint; kind: RiftCallKind },
): Promise<RiftQuote> {
  const check = (names: Readonly<Record<string, string>>) => parseQuote(json, { ...expect, source: { fromAsset: expect.fromAsset, names } });
  const asked = { from: expect.fromAsset, to: expect.destination };
  try {
    return check(riftNames());
  } catch (e) {
    const names = riftNames();
    const unknown = unknownNames(json, names);
    if (!unknown.length || resolve.rawAmount <= 0n) throw e;
    // Worth a lookup only if the answer passes with each unknown name standing for the token asked for in its
    // place; otherwise it is wrong whatever the names stand for, and is refused without a call.
    try { check({ ...names, ...guessNames(json, asked, names) }); } catch { throw e; }
    // A route check's name lookup comes straight after its quote, so it is held to the poll limit, not the
    // probes' 15 s spacing (which would never let it go).
    if (resolve.kind !== 'user' && !riftBudget(resolve.kind === 'probe' ? 'poll' : resolve.kind)) {
      throw new NameLookupPending(e instanceof Error ? e.message : String(e));
    }
    const raw = await fetchQuote(
      { from: expect.fromAsset, from_amount: resolve.rawAmount.toString(), quote_mode: 'fast', format: 'raw' }, undefined, resolve.kind,
    );
    if (!raw || typeof raw !== 'object' || (raw as { from_amount?: unknown }).from_amount !== resolve.rawAmount.toString()) throw e;
    const pairs = namesToLearn(json, raw, asked);
    // Only the names that were unknown are learned: a name already known is never re-pointed.
    const fresh = Object.fromEntries(Object.entries(pairs ?? {}).filter(([n]) => unknown.includes(n)));
    if (!Object.keys(fresh).length) throw e;
    rememberNames(fresh);
    return check(riftNames());
  }
}
