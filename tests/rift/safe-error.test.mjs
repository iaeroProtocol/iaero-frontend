// Run: npm run test:rift (Node strips the TypeScript types).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeErrorText } from '../../src/lib/safe-error.ts';

test('errors are logged without the URLs that viem and ethers repeat (an RPC URL can carry an API key)', () => {
  const viemLike = Object.assign(
    new Error('HTTP request failed.\n\nStatus: 403\nURL: https://base-mainnet.g.alchemy.com/v2/SECRETKEY\nRequest body: {}'),
    { name: 'HttpRequestError', shortMessage: 'HTTP request failed.' },
  );
  assert.equal(safeErrorText(viemLike), 'HttpRequestError: HTTP request failed.');
  assert.ok(!safeErrorText(new Error('fetch https://x.g.alchemy.com/v2/SECRETKEY failed')).includes('SECRETKEY'));
  const ethersLike = new Error('server response 403 (request={ }, info={ "requestUrl": "https://mainnet.example/v3/SECRETKEY" }, code=SERVER_ERROR)');
  assert.ok(!safeErrorText(ethersLike).includes('SECRETKEY'));
  assert.equal(safeErrorText('plain text'), 'plain text');
  assert.equal(safeErrorText(null), 'null');
});
