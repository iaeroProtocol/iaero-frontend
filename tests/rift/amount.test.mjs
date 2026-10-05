// Run: npm run test:rift (Node strips the TypeScript types).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localeDecimalSep, parseAmountInput, toInputText } from '../../src/lib/rift/amount.ts';

test('amounts are read the way they were meant', () => {
  const v = (t, d = 18) => parseAmountInput(t, d).value;
  assert.equal(v('1234.5'), '1234.5');
  assert.equal(v('1,234.50'), '1234.5', 'comma groups, dot decimal');
  assert.equal(v('1.234,50'), '1234.5', 'dot groups, comma decimal');
  assert.equal(v('1 234,5'), '1234.5');
  assert.equal(v('0,5'), '0.5', 'a single comma is a decimal comma');
  assert.equal(v('1.000.000'), '1000000');
  assert.equal(v('1,000,000'), '1000000');
  assert.equal(v('.5'), '0.5');
  assert.equal(v('12.'), '12', 'still typing');
  assert.equal(v('007.10'), '7.1');
  assert.deepEqual(parseAmountInput('', 18), {});
  assert.deepEqual(parseAmountInput('0.000', 18), {}, 'zero is no amount yet');
});

test('a leading "0," is always a decimal comma (it was read 1000x too large)', () => {
  const v = (t, d = 18) => parseAmountInput(t, d).value;
  assert.equal(v('0,500'), '0.5');
  assert.equal(v('0,025'), '0.025');
  assert.equal(v('0,100', 6), '0.1');
  assert.equal(v('0.500'), '0.5');
  assert.equal(parseAmountInput('0,500', 18).ambiguous, undefined, 'not ambiguous: no number starts with a 0 group');
  assert.ok(parseAmountInput('0,500,000', 18).error, 'a 0 thousands group is not a number');
});

test('"1,500" follows the browser: thousands with a dot decimal, a decimal with a comma decimal', () => {
  assert.deepEqual(parseAmountInput('1,500', 18, '.'), { value: '1500', ambiguous: true });
  assert.deepEqual(parseAmountInput('1,500', 18, ','), { value: '1.5', ambiguous: true });
  assert.deepEqual(parseAmountInput('1.500', 18, '.'), { value: '1.5', ambiguous: true });
  assert.deepEqual(parseAmountInput('1.500', 18, ','), { value: '1500', ambiguous: true });
  assert.deepEqual(parseAmountInput('12,5', 18, '.'), { value: '12.5' }, 'not three digits: a decimal comma');
  assert.equal(localeDecimalSep('de-DE'), ',');
  assert.equal(localeDecimalSep('en-US'), '.');
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

test('amounts the page writes itself read back as the same number in every locale', () => {
  for (const sep of ['.', ',']) {
    for (const [decimal, decimals] of [['12.345', 6], ['250.125', 18], ['0.5', 18], ['1234.5678', 8], ['1000', 6], ['0.000001', 6]]) {
      assert.equal(parseAmountInput(toInputText(decimal, sep), decimals, sep).value, decimal, `${decimal} with "${sep}"`);
    }
  }
  assert.equal(toInputText('12.345', ','), '12,345');
  assert.equal(toInputText('12.345', '.'), '12.345');
});
