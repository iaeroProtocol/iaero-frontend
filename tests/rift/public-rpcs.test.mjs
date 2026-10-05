// Run: npm run test:rift (Node strips the TypeScript types).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PUBLIC_RPCS, rpcUrls } from '../../src/lib/public-rpcs.ts';

test('anonymous server reads never use the private Alchemy key', () => {
  const saved = process.env.ALCHEMY_SERVER_KEY;
  try {
    process.env.ALCHEMY_SERVER_KEY = 'test-key';
    for (const chain of [1, 42161, 8453]) {
      assert.deepEqual(rpcUrls(chain, { server: true }), [...PUBLIC_RPCS[chain]]);
      assert.ok(!rpcUrls(chain).some(u => u.includes('test-key')), 'the server key never reaches the browser list');
    }
  } finally {
    if (saved === undefined) delete process.env.ALCHEMY_SERVER_KEY; else process.env.ALCHEMY_SERVER_KEY = saved;
  }
});
