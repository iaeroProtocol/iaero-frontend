// Run: npm run test:rift (Node strips the TypeScript types).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HYPERCORE_TOKENS, hyperCoreHoldings, hyperCoreToken, parseSpotBalances, spotSendRequest, spotSendResult, spotSendToken,
  spotSendTypedData,
} from '../../src/lib/rift/hypercore.ts';

test('HyperCore spot balances: only the tokens Rift routes, minus what orders hold', () => {
  // Shape of Hyperliquid's spotClearinghouseState (2026-10-02).
  const json = { balances: [
    { coin: 'USDC', token: 0, total: '45207.797215', hold: '9999.768', entryNtl: '0.0' },
    { coin: 'PURR', token: 1, total: '0.62505', hold: '0.0' },
    { coin: 'HYPE', token: 150, total: '12.5', hold: '0.0' },
    { coin: 'UBTC', token: 197, total: '0.0003', hold: '0.0003' },
    { coin: 'FAKE', token: 150, total: '9', hold: '0' },
  ] };
  const rows = parseSpotBalances(json);
  assert.deepEqual(rows.map(r => [r.token.symbol, r.availableRaw]), [['USDC', 3520802921500n], ['HYPE', 1250000000n]]);
  assert.deepEqual(parseSpotBalances({}), []);
  const llama = { coins: { 'coingecko:usd-coin': { price: 0.9999 }, 'coingecko:hyperliquid': { price: 40 } } };
  const [usdc, hype] = hyperCoreHoldings(rows, llama);
  assert.equal(hype.asset, 'hyperliquid.hype');
  assert.equal(hype.chain, 'hyperliquid');
  assert.equal(hype.valueUsd, 500);
  assert.ok(Math.abs(usdc.valueUsd - 35204.5) < 0.1);
  assert.equal(hyperCoreToken('HYPERLIQUID.BTC')?.symbol, 'UBTC');
});

test("the signed transfer matches Rift's documented example", () => {
  const usdc = HYPERCORE_TOKENS.find(t => t.symbol === 'USDC');
  assert.equal(spotSendToken(usdc), 'USDC:0x6d1e7cde53ba9467b783cb7c530ce054');
  const t = { destination: '0xA99BFF71F916393399CCA2E3E90CC09B53A2CC2F', token: spotSendToken(usdc), amount: '25.5', time: 1790927000000 };
  const typed = spotSendTypedData(t);
  assert.deepEqual(typed.domain, { name: 'HyperliquidSignTransaction', version: '1', chainId: 42161, verifyingContract: '0x0000000000000000000000000000000000000000' });
  assert.equal(typed.primaryType, 'HyperliquidTransaction:SpotSend');
  assert.deepEqual(typed.types['HyperliquidTransaction:SpotSend'].map(f => `${f.name}:${f.type}`),
    ['hyperliquidChain:string', 'destination:string', 'token:string', 'amount:string', 'time:uint64']);
  assert.equal(typed.message.destination, '0xa99bff71f916393399cca2e3e90cc09b53a2cc2f', 'lowercase, as signed');
  assert.equal(typed.message.time, 1790927000000n);
  const body = spotSendRequest(t, { r: '0x01', s: '0x02', v: 27 });
  assert.equal(body.action.type, 'spotSend');
  assert.equal(body.action.signatureChainId, '0xa4b1');
  assert.equal(body.action.destination, typed.message.destination, 'the request repeats exactly what was signed');
  assert.equal(body.action.time, 1790927000000);
  assert.equal(body.nonce, 1790927000000);
  assert.deepEqual(spotSendResult({ status: 'ok', response: { type: 'default' } }), { ok: true });
  assert.deepEqual(spotSendResult({ status: 'err', response: 'Insufficient balance for token transfer' }),
    { ok: false, error: 'Insufficient balance for token transfer' });
});

test('portfolio margin: borrowed USDC is not a holding; Hyperliquid caps what can leave', async () => {
  const { parseSpotBalances, usdcForFee } = await import('../../src/lib/rift/hypercore.ts');
  // 0x010B…9831 on 2026-10-02 (portfolio margin, USDC borrowed against HYPE and UBTC).
  const json = {
    portfolioMarginEnabled: true,
    balances: [
      { coin: 'USDC', token: 0, total: '-19.82441338', hold: '-33048.21587637' },
      { coin: 'HYPE', token: 150, total: '326.26045663', hold: '0.0' },
      { coin: 'UBTC', token: 197, total: '0.3208182284', hold: '0.0' },
    ],
    tokenToAvailableAfterMaintenance: [[0, '45123.29019999'], [150, '300.5'], [197, '0.3208182284']],
  };
  const rows = parseSpotBalances(json);
  assert.deepEqual(rows.map(r => [r.token.symbol, r.availableRaw]), [['HYPE', 30050000000n], ['UBTC', 3208182284n]], 'HYPE capped at what can leave');
  assert.equal(usdcForFee(json), 45123.29019999, 'the fee can come from margin');
  assert.equal(usdcForFee({ balances: [{ coin: 'USDC', token: 0, total: '0.5', hold: '0' }] }), 0.5);
});
