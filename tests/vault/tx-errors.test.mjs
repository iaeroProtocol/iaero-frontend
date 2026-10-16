// Run: npm run test:vault (Node strips the TypeScript types).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContractFunctionExecutionError, ContractFunctionRevertedError, encodeErrorResult } from 'viem';
import { isEnforcedPause } from '../../src/components/lib/tx-errors.ts';

const vault = '0x180DAB53968e599Dd43CF431E27CB01AA5C37909';
const pauseAbi = [{ type: 'error', name: 'EnforcedPause', inputs: [] }];
const wrap = (abi, data) => new ContractFunctionExecutionError(
  new ContractFunctionRevertedError({ abi, data, functionName: 'deposit' }),
  { abi, functionName: 'deposit', args: [1n], contractAddress: vault });

test('a paused PermalockVault deposit is recognised however the error arrives', () => {
  // 2026-10-16: deposit(1) and depositVeNFT(1) on Base revert with exactly this data (eth_call).
  assert.equal(isEnforcedPause(wrap(pauseAbi, '0xd93c0665')), true, 'decoded by name from the vault ABI');
  assert.equal(isEnforcedPause(wrap([], '0xd93c0665')), true, 'only the selector, when the ABI lacks the error');
  assert.equal(isEnforcedPause({ message: 'execution reverted', data: '0xd93c0665' }), true, 'a raw wallet RPC error');
  const emergency = encodeErrorResult({
    abi: [{ type: 'error', name: 'Error', inputs: [{ type: 'string' }] }], errorName: 'Error', args: ['Emergency pause active'],
  });
  assert.equal(isEnforcedPause(wrap([], emergency)), true, "the vault's emergency flag");
});

test('other failures are not called a pause', () => {
  assert.equal(isEnforcedPause(wrap([{ type: 'error', name: 'Unauthorized', inputs: [] }], '0x82b42900')), false);
  assert.equal(isEnforcedPause(Object.assign(new Error('User rejected the request.'), { code: 4001 })), false);
  assert.equal(isEnforcedPause(new Error('insufficient funds for gas * price + value')), false);
  assert.equal(isEnforcedPause(undefined), false);
});
