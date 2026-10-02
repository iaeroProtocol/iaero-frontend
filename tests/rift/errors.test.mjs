// Run: npm run test:rift (Node strips the TypeScript types).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RiftApiError, classifyRiftError, explainRiftError } from '../../src/lib/rift/errors.ts';

const kind = (status, message) => classifyRiftError(new RiftApiError(status, message));

test("Rift's real error texts are told apart", () => {
  // 2026-10-02: an hour-long pricing outage (also returned for some tokens Rift cannot route). Not "no route".
  assert.equal(kind(422, 'execution costs could not be priced, so no route was evaluated in full'), 'unavailable');
  assert.equal(kind(422, 'no venue returned an executable quote'), 'no_route');
  assert.equal(kind(422, 'evm:8453.0x000000000000000000000000000000000000beef is not a known asset'), 'unsupported');
  assert.equal(kind(400, 'unknown chain: solana'), 'unsupported');
  assert.equal(kind(422, 'something new'), 'unavailable', 'an unknown 422 is not cached as an answer');
  assert.equal(kind(429, 'error code: 1015'), 'rate_limited');
  assert.equal(kind(409, 'quote already used'), 'quote_used');
  assert.equal(kind(0, 'Could not reach Rift'), 'network');
  assert.equal(kind(502, 'bad gateway'), 'unavailable');
  assert.equal(classifyRiftError(new Error('x')), 'other');
  assert.equal(new RiftApiError(422, 'x').status, 422);
  assert.match(explainRiftError(new RiftApiError(422, 'execution costs could not be priced, so no route was evaluated in full')), /can’t price routes right now/);
});
