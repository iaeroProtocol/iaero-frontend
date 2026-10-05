// Run: npm run test:rift (Node strips the TypeScript types).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PUBLIC_RPCS, rpcUrls } from '../../src/lib/public-rpcs.ts';

test('server reads try the public endpoints first and the server key last, only when it is set', () => {
  const saved = process.env.ALCHEMY_SERVER_KEY;
  try {
    delete process.env.ALCHEMY_SERVER_KEY;
    assert.deepEqual(rpcUrls(8453, { server: true }), [...PUBLIC_RPCS[8453]]);
    process.env.ALCHEMY_SERVER_KEY = 'test-key';
    const urls = rpcUrls(42161, { server: true });
    assert.deepEqual(urls.slice(0, -1), [...PUBLIC_RPCS[42161]]);
    assert.equal(urls.at(-1), 'https://arb-mainnet.g.alchemy.com/v2/test-key', 'read on each call, not at import');
    assert.ok(!rpcUrls(1).some(u => u.includes('test-key')), 'the server key never reaches the browser list');
  } finally {
    if (saved === undefined) delete process.env.ALCHEMY_SERVER_KEY; else process.env.ALCHEMY_SERVER_KEY = saved;
  }
});
