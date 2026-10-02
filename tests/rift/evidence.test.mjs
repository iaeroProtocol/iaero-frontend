// Run: npm run test:rift (Node strips the TypeScript types).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeEvmDeposit, judgeHyperLedger } from '../../src/lib/rift/evidence.ts';

test('EVM deposit address: any sign of a payment counts', () => {
  const need = 10_000_000n;
  assert.equal(judgeEvmDeposit({ balance: need, need, nonce: 0, code: '0x' }), 'arrived', 'waiting for Rift');
  assert.equal(judgeEvmDeposit({ balance: 5n, need, nonce: 4, code: '0x' }), 'arrived', 'executed: Rift spent it, leaving 5 base units (three real orders)');
  assert.equal(judgeEvmDeposit({ balance: 0n, need, nonce: 0, code: `0xef0100${'11'.repeat(20)}` }), 'arrived', 'code set by Rift');
  assert.equal(judgeEvmDeposit({ balance: 9_990_000n, need, nonce: 0, code: '0x' }), 'partial', 'a fee-on-transfer token, or less sent');
  assert.equal(judgeEvmDeposit({ balance: 0n, need, nonce: 0, code: '0x' }), 'none');
  assert.equal(judgeEvmDeposit({ balance: 0n, need, nonce: 0 }), 'none');
});

test('HyperCore: the payer ledger, by destination, token and time', () => {
  const owner = '0x010B23B2f2A5F6bC4ce0c68A5f65c248c1129831';
  const deposit = '0xA99BFF71F916393399CCA2E3E90CC09B53A2CC2F';
  const since = 1_790_000_000_000;
  // Entry shape from userNonFundingLedgerUpdates (2026-10-02).
  const entry = (over = {}, delta = {}) => ({
    time: since + 5000, hash: '0x4af4',
    delta: { type: 'spotTransfer', token: 'HYPE', amount: '12.5', usdcValue: '500', user: owner.toLowerCase(), destination: deposit.toLowerCase(), fee: '0.0', ...delta },
    ...over,
  });
  const judge = (json, need = 12.5) => judgeHyperLedger(json, { owner, deposit, symbol: 'HYPE', need, since });
  assert.deepEqual(judge([entry()]), { evidence: 'arrived', hash: '0x4af4', time: since + 5000 });
  assert.equal(judge([entry({}, { amount: '6' })]).evidence, 'partial');
  assert.equal(judge([entry({}, { amount: '6' }), entry({ hash: '0x2' }, { amount: '6.5' })]).evidence, 'arrived', 'two transfers');
  assert.equal(judge([entry({}, { destination: '0x2222222222222222222222222222222222222222' })]).evidence, 'none', 'elsewhere');
  assert.equal(judge([entry({}, { token: 'USDC' })]).evidence, 'none', 'another token');
  assert.equal(judge([entry({ time: since - 1 })]).evidence, 'none', 'before the order');
  assert.equal(judge([entry({}, { type: 'deposit' })]).evidence, 'none');
  assert.equal(judge({}).evidence, 'none');
});
