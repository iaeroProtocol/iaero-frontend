// The holdings route's GET, end to end: the real holdings, hypercore, cost, blockscout-pages and rate-limit modules,
// a stub chain (balances), and stub Blockscout, Hyperliquid and DeFiLlama answers. Run: npm run test:rift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as holdings from '../../src/lib/rift/holdings.ts';
import * as hypercore from '../../src/lib/rift/hypercore.ts';
import * as cost from '../../src/lib/rift/cost.ts';
import * as pages from '../../src/lib/rift/blockscout-pages.ts';
import * as rl from '../../src/lib/rift/rate-limit.ts';
import { RIFT_LISTED } from '../../src/lib/rift/rift-tokens.ts';

const cfgSrc = ts.transpileModule(readFileSync(new URL('../../src/lib/rift/config.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const config = {};
vm.runInNewContext(cfgSrc, { exports: config, require: n => (n === './hypercore' ? hypercore : (() => { throw new Error(n); })()) });
const src = readFileSync(new URL('../../src/app/api/rift/holdings/route.ts', import.meta.url), 'utf8');
const cjs = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

class NextResponse {
  constructor(body, init = {}) { this.body = body; this.status = init.status ?? 200; }
  static json(obj, init = {}) { return new NextResponse(JSON.stringify(obj), init); }
}

/** `balances`: chainId -> { eth: bigint, tokens: { addr: bigint } }; `blockscout`: chain -> rows; `llama`: coins object. */
function makeRoute({ balances, blockscout = {}, llama = { coins: {} }, hyper = { balances: [] } }) {
  const exports = {};
  const client = chainId => ({
    getBalance: async () => balances[chainId]?.eth ?? 0n,
    multicall: async ({ contracts }) => contracts.map(c => {
      if (c.functionName === 'getEthBalance') return { status: 'success', result: balances[chainId]?.eth ?? 0n };
      if (c.functionName === 'balanceOf') return { status: 'success', result: balances[chainId]?.tokens?.[c.address.toLowerCase()] ?? 0n };
      if (c.functionName === 'decimals') return { status: 'success', result: 18 };
      return { status: 'failure', error: new Error('?') };
    }),
  });
  const fetch = async (url, init) => {
    const u = String(url);
    const json = body => ({ ok: true, status: 200, json: async () => body });
    if (u.startsWith("https://coins.llama.fi/")) { (globalThis.__llamaUrls ??= []).push(u); return json(llama); }
    if (u.includes('/api/v2/stats')) return json({ coin_price: '4000' });
    if (u.includes('hyperliquid')) return json(hyper);
    const m = /https:\/\/(eth|arbitrum|base)\.blockscout\.com\/api\/v2\/addresses\/0x[0-9a-f]{40}\/tokens/.exec(u);
    if (m) return json({ items: blockscout[{ eth: 'ethereum', arbitrum: 'arbitrum', base: 'base' }[m[1]]] ?? [], next_page_params: null });
    if (u.includes('blockscout.com/api/v2/addresses/')) return json({ coin_balance: '0' });
    throw new Error(`unexpected fetch ${u}`);
  };
  let made = 0;
  vm.runInNewContext(cjs, {
    exports, Date, Promise, setTimeout, clearTimeout, Map, Set, Number, BigInt, Math, JSON, Error, Array, Object, Request, Response, URL, AbortController, String,
    fetch,
    require: n => ({
      'next/server': { NextResponse },
      viem: { createPublicClient: ({ chain }) => client(chain.id), erc20Abi: 'ERC20', fallback: () => ({}), http: () => ({}) },
      'viem/chains': { arbitrum: { id: 42161 }, base: { id: 8453 }, mainnet: { id: 1 } },
      '@/lib/rift/config': config,
      '@/lib/rift/rift-tokens': { RIFT_LISTED },
      '@/lib/rift/server': { EVM_ADDRESS_RE: /^0x[0-9a-fA-F]{40}$/, badRequest: e => NextResponse.json({ error: e }, { status: 400 }) },
      '@/lib/rift/cost': cost,
      '@/lib/rift/holdings': holdings,
      '@/lib/rift/hypercore': hypercore,
      '@/lib/rift/blockscout-pages': pages,
      '@/lib/rift/rate-limit': rl,
      '@/lib/public-rpcs': { rpcUrls: () => ['http://rpc'] },
    })[n] ?? (() => { throw new Error(`unexpected import ${n}`); })(),
  });
  return async (address, ip = `10.0.0.${++made}`) => {
    const req = { nextUrl: new URL(`https://x.invalid/api/rift/holdings?address=${address}&fresh=1`), headers: new Map([['cf-connecting-ip', ip]]) };
    req.headers.get = k => Map.prototype.get.call(req.headers, k) ?? null;
    const res = await exports.GET(req);
    return JSON.parse(res.body);
  };
}

const owner = '0x2222222222222222222222222222222222222222';
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const row = (address, symbol, decimals, value, exchange_rate = null) =>
  ({ value, token: { type: 'ERC-20', address_hash: address, symbol, name: symbol, decimals, exchange_rate } });
const sec = () => Math.floor(Date.now() / 1000);

test('round 11: a major token is valued at DeFiLlama\'s price, not a wrong tiny one from Blockscout', async () => {
  const balances = { 8453: { eth: 0n, tokens: { [USDC_BASE]: 5_000_000_000n } } }; // 5,000 USDC on Base
  const llama = { coins: { [`base:${USDC_BASE}`]: { price: 1.0, timestamp: sec() - 60, confidence: 0.99 } } };
  const body = await makeRoute({ balances, blockscout: { base: [row(USDC_BASE, 'USDC', '6', '5000000000', '0.0000001')] }, llama })(owner);
  const usdc = body.holdings.find(h => h.chain === 'base' && h.symbol === 'USDC');
  assert.ok(usdc, 'listed, not dropped as dust');
  assert.equal(usdc.priceUsd, 1);
  assert.ok(Math.abs(usdc.valueUsd - 5000) < 1e-6);
});

test('round 11: a nonsense ETH price lists ETH unvalued rather than dropping it as dust', async () => {
  const balances = { 8453: { eth: 2_000_000_000_000_000_000n, tokens: {} } }; // 2 ETH on Base
  const llama = { coins: { 'coingecko:ethereum': { price: 1e-300, timestamp: sec() - 60, confidence: 0.99 } } };
  const body = await makeRoute({ balances, llama })(owner);
  const eth = body.holdings.find(h => h.chain === 'base' && !h.address);
  assert.ok(eth, 'still listed');
  assert.ok(eth.priceMissing || eth.priceUsd >= 1, JSON.stringify(eth));
});
