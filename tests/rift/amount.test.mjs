// Run: npm run test:rift (Node strips the TypeScript types).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmountInput } from '../../src/lib/rift/amount.ts';

test('amounts are read the way they were meant', () => {
  const v = (t, d = 18) => parseAmountInput(t, d).value;
  assert.equal(v('1234.5'), '1234.5');
  assert.equal(v('1,234.50'), '1234.5', 'comma groups, dot decimal');
  assert.equal(v('1.234,50'), '1234.5', 'dot groups, comma decimal');
  assert.equal(v('1 234,5'), '1234.5');
  assert.equal(v('0,5'), '0.5', 'a single comma is a decimal comma');
  assert.equal(v('1,000'), '1000', 'thousands');
  assert.equal(v('1.000.000'), '1000000');
  assert.equal(v('.5'), '0.5');
  assert.equal(v('12.'), '12', 'still typing');
  assert.equal(v('007.10'), '7.1');
  assert.deepEqual(parseAmountInput('', 18), {});
  assert.deepEqual(parseAmountInput('0.000', 18), {}, 'zero is no amount yet');
});

test('nothing is rewritten silently', () => {
  const e = (t, d = 18) => parseAmountInput(t, d).error;
  assert.ok(e('1e-5'), 'an exponent used to become 15');
  assert.ok(e('2.5e3'));
  assert.ok(e('-1'));
  assert.ok(e('1.2.3'));
  assert.ok(e('1,2,3'));
  assert.ok(e('1,23.4'), 'a malformed group');
  assert.ok(e('abc'));
  assert.equal(e('0.1234567', 6), 'At most 6 decimal places');
  assert.equal(e('1.5', 0), 'Whole numbers only');
  assert.equal(parseAmountInput('0.123456', 6).value, '0.123456');
});
