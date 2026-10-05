// The holdings route's on-chain reads (readBalances, chainHoldings in src/app/api/rift/holdings/route.ts), run
// against a stub chain and a stub Blockscout. Run: npm run test:rift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as holdings from '../../src/lib/rift/holdings.ts';

const src = readFileSync(new URL('../../src/app/api/rift/holdings/route.ts', import.meta.url), 'utf8')
  + '\nexport const __readBalances = readBalances;\nexport const __chainHoldings = chainHoldings;';
const cjs = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

const addr = i => `0x${(0xabc000 + i).toString(16).padStart(40, '0')}`;
const MAJORS = [0, 1, 2].map(addr); // on our own list: no decimals() read
const owner = '0x2222222222222222222222222222222222222222';

/** The route module with `chain` as every RPC client and `rows` as Blockscout's token list. */
function load(chain, rows = []) {
  const exports = {};
  vm.runInNewContext(cjs, {
    exports, Date, Promise, setTimeout, clearTimeout, Map, Set, Number, BigInt, Math, JSON, Error, Array, Object, Request, Response, URL,
    require: n => ({
      'next/server': { NextResponse: class {} },
      viem: { createPublicClient: () => chain, erc20Abi: 'ERC20', fallback: () => ({}), http: () => ({}) },
      'viem/chains': { arbitrum: {}, base: {}, mainnet: {} },
      '@/lib/rift/config': {
        CURATED_TOKENS: MAJORS.map((a, i) => ({ chain: 'base', asset: `base.${a}`, address: a, symbol: `M${i}`, name: `M${i}`, decimals: 18 })),
        RIFT_DESTINATION: 'base.0x81034fb34009115f215f5d5f564aac9ffa46a1dc',
      },
      '@/lib/rift/rift-tokens': { RIFT_LISTED: new Set() },
      '@/lib/rift/server': { EVM_ADDRESS_RE: /^0x[0-9a-fA-F]{40}$/, badRequest: () => null },
      '@/lib/rift/cost': { parseLlamaPrices: () => ({}) },
      '@/lib/rift/holdings': holdings,
      '@/lib/rift/hypercore': { HL_API: '', HYPERCORE_TOKENS: [], hyperCoreHoldings: () => [], parseSpotBalances: () => [], usdcForFee: () => 0 },
      '@/lib/rift/blockscout-pages': { collectTokenPages: async () => ({ items: rows, complete: true, truncated: false }) },
      '@/lib/rift/rate-limit': { RateLimiter: class { over() { return false; } }, rateKey: x => x, touch() {} },
      '@/lib/public-rpcs': { rpcUrls: () => ['http://rpc'] },
    })[n] ?? (() => { throw new Error(`unexpected import ${n}`); })(),
  });
  return { readBalances: exports.__readBalances, chainHoldings: exports.__chainHoldings };
}

/** A chain where token i holds 1000+i and has decimals 8+(i%10). `hostile` tokens break any batch they are in;
 *  `failFirst`: the first multicall rejects (out of time); `tokensFail`: every multicall fails; `down`: nothing answers. */
function chain({ hostile = new Set(), failFirst = false, tokensFail = false, down = false, oursFail = false } = {}) {
  const log = [];
  return {
    log,
    getBalance: async () => { if (down || oursFail) throw new Error('down'); return 777n; },
    multicall: async ({ contracts }) => {
      log.push(contracts.length);
      if (failFirst && log.length === 1) throw new Error('out of time');
      const ours = contracts.some(c => c.functionName === 'getEthBalance');
      const breaks = tokensFail || down || (oursFail && ours) || contracts.some(c => hostile.has(c.address));
      return contracts.map(c => {
        if (breaks) return { status: 'failure', error: new Error('response too large') };
        if (c.functionName === 'getEthBalance') return { status: 'success', result: 777n };
        const i = parseInt(c.address.slice(2), 16) - 0xabc000;
        if (c.functionName === 'balanceOf') return { status: 'success', result: BigInt(1000 + i) };
        if (c.functionName === 'decimals') return { status: 'success', result: 8 + (i % 10) };
        throw new Error('unexpected call');
      });
    },
  };
}
const tokens = n => Array.from({ length: n }, (_, i) => ({ address: addr(i), symbol: `T${i}`, name: `T${i}`, decimals: 18, priceUsd: 0 }));
const soon = () => Date.now() + 20_000;

test('two multicalls, ours and the rest: every token gets its own balance and decimals', async () => {
  const c = chain();
  const r = await load(c).readBalances(8453, owner, tokens(40), soon());
  assert.deepEqual([...c.log].sort((a, b) => a - b), [4, 74], 'ETH with our 3 tokens; 37 others, balance and decimals each');
  assert.equal(r.native, 777n);
  assert.equal(r.incomplete, false);
  r.tokens.forEach((t, i) => assert.equal(t.decimals, i < 3 ? 18 : 8 + (i % 10), `decimals of token ${i}`));
  r.balances.forEach((b, i) => assert.equal(b, BigInt(1000 + i), `balance of token ${i}`));
});

test('a hostile token costs at most a few others, and every other token keeps its own numbers', async () => {
  for (const [n, h] of [[120, 37], [120, 3], [120, 119], [60, 0]]) {
    const r = await load(chain({ hostile: new Set([addr(h)]) })).readBalances(8453, owner, tokens(n), soon());
    assert.equal(r.native, 777n);
    assert.equal(r.incomplete, true);
    const lost = r.balances.filter((b, i) => b === null && i !== h).length;
    assert.ok(lost <= 2, `${n} tokens, hostile ${h}: ${lost} others lost`);
    r.balances.forEach((b, i) => { if (b !== null) assert.equal(b, BigInt(1000 + i)); });
  }
});

test('a first read that fails outright, or runs out of time, is read again in halves', async () => {
  // Another audit, Medium 5: the rejection skipped the retry and went straight to Blockscout's numbers.
  const c = chain({ failFirst: true });
  const r = await load(c).readBalances(8453, owner, tokens(40), soon());
  assert.ok(r, 'read on-chain after all');
  assert.equal(r.native, 777n);
  r.balances.forEach((b, i) => assert.equal(b, BigInt(1000 + i), `balance of token ${i}`));
  assert.ok(c.log.length > 1);
});

test('ETH read on its own is kept when every token read fails, and for a wallet with no token candidates', async () => {
  // Another audit, Medium 6: the rescued ETH balance was dropped, and Blockscout's (possibly stale) numbers used.
  const failing = await load(chain({ tokensFail: true })).readBalances(8453, owner, tokens(10), soon());
  assert.equal(failing.native, 777n);
  assert.ok(failing.balances.every(b => b === null));
  const none = await load(chain({ tokensFail: true })).readBalances(8453, owner, [], soon());
  assert.equal(none.native, 777n);
  // The chain's picture: ETH from the chain, the tokens from Blockscout, flagged.
  const rows = [{ value: '5000000', token: { type: 'ERC-20', address_hash: addr(50), symbol: 'BLK', name: 'Blk', decimals: '6', exchange_rate: '1' } }];
  const report = { warnings: [], notes: [] };
  const out = await load(chain({ tokensFail: true }), rows).chainHoldings('base', 8453, 'https://blockscout.invalid', owner, true, report, soon());
  assert.deepEqual([...out].map(h => [h.symbol, h.balanceRaw]).sort(), [['BLK', '5000000'], ['ETH', '777']]);
  assert.ok(report.warnings.some(w => /could not be checked on-chain and may be out of date/.test(w)), report.warnings.join(' | '));
});

test('airdropped tokens that break their batch can never hide ours, nor ETH', async () => {
  // Round 2, Medium: two batch-breakers among the unlisted tokens dropped every major token on the chain.
  for (const breakers of [[3, 22], [3, 4], [10, 60, 110]]) {
    const r = await load(chain({ hostile: new Set(breakers.map(addr)) })).readBalances(8453, owner, tokens(120), soon());
    assert.equal(r.native, 777n);
    [0, 1, 2].forEach(i => assert.equal(r.balances[i], BigInt(1000 + i), `our token ${i}, breakers ${breakers}`));
  }
});

test('our tokens are always sized with our decimals, even from Blockscout\u2019s numbers', async () => {
  // Round 2, High: with the on-chain read failing, Blockscout's (wrong) decimals reached a curated token, and the
  // page then sent many times the amount ordered.
  const rows = [{ value: '10000000000000000000000', token: { type: 'ERC-20', address_hash: addr(0), symbol: 'M0', name: 'M0', decimals: '8', exchange_rate: '1' } }];
  for (const c of [chain({ tokensFail: true }), chain({ down: true })]) {
    const out = await load(c, rows).chainHoldings('base', 8453, 'https://blockscout.invalid', owner, true, { warnings: [], notes: [] }, soon());
    const m0 = out.find(h => h.symbol === 'M0');
    assert.equal(m0?.decimals, 18, 'config decimals, not Blockscout\u2019s 8');
  }
});

test('a damaged Blockscout row never drops the chain', async () => {
  const rows = [
    { value: '5', token: { type: 'ERC-20', address_hash: addr(70), symbol: 5, name: { x: 1 }, decimals: '6', exchange_rate: '1' } },
    { value: '6', token: { type: 'ERC-20', address_hash: addr(71), symbol: 'OK', name: 'Ok', decimals: '6', exchange_rate: '1' } },
  ];
  const report = { warnings: [], notes: [] };
  const out = await load(chain(), rows).chainHoldings('base', 8453, 'https://blockscout.invalid', owner, true, report, soon());
  assert.ok(out.some(h => h.symbol === 'ETH'));
  assert.ok(!report.warnings.some(w => /unavailable/.test(w)), report.warnings.join(' | '));
});

test('ETH whose batch failed while the tokens\u2019 answered comes from Blockscout, flagged', async () => {
  // Round 3, Low: ETH dropped out of the picker when only the trusted batch (and the probe) failed.
  const exports = {};
  vm.runInNewContext(cjs, {
    exports, Date, Promise, setTimeout, clearTimeout, Map, Set, Number, BigInt, Math, JSON, Error, Array, Object, Request, Response, URL, AbortController,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ coin_balance: '555', exchange_rate: '2000' }) }),
    require: n => ({
      'next/server': { NextResponse: class {} },
      viem: { createPublicClient: () => chain({ oursFail: true }), erc20Abi: 'ERC20', fallback: () => ({}), http: () => ({}) },
      'viem/chains': { arbitrum: {}, base: {}, mainnet: {} },
      '@/lib/rift/config': {
        CURATED_TOKENS: MAJORS.map((a, i) => ({ chain: 'base', asset: `base.${a}`, address: a, symbol: `M${i}`, name: `M${i}`, decimals: 18 })),
        RIFT_DESTINATION: 'base.0x81034fb34009115f215f5d5f564aac9ffa46a1dc',
      },
      '@/lib/rift/rift-tokens': { RIFT_LISTED: new Set() },
      '@/lib/rift/server': { EVM_ADDRESS_RE: /^0x[0-9a-fA-F]{40}$/, badRequest: () => null },
      '@/lib/rift/cost': { parseLlamaPrices: () => ({}) },
      '@/lib/rift/holdings': holdings,
      '@/lib/rift/hypercore': { HL_API: '', HYPERCORE_TOKENS: [], hyperCoreHoldings: () => [], parseSpotBalances: () => [], usdcForFee: () => 0 },
      // An unlisted token, so the untrusted batch has something to answer.
      '@/lib/rift/blockscout-pages': { collectTokenPages: async () => ({
        items: [{ value: '5', token: { type: 'ERC-20', address_hash: addr(60), symbol: 'U', name: 'U', decimals: '8', exchange_rate: '1' } }],
        complete: true, truncated: false,
      }) },
      '@/lib/rift/rate-limit': { RateLimiter: class { over() { return false; } }, rateKey: x => x, touch() {} },
      '@/lib/public-rpcs': { rpcUrls: () => ['http://rpc'] },
    })[n] ?? (() => { throw new Error(`unexpected import ${n}`); })(),
  });
  const report = { warnings: [], notes: [] };
  const out = await exports.__chainHoldings('base', 8453, 'https://blockscout.invalid', owner, true, report, soon());
  assert.equal([...out].find(h => h.symbol === 'ETH')?.balanceRaw, '555');
  assert.ok(report.warnings.some(w => /ETH balance could not be checked on-chain/.test(w)), report.warnings.join(' | '));
});
