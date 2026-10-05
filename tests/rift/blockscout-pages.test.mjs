import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_TOKEN_ROWS, collectTokenPages } from '../../src/lib/rift/blockscout-pages.ts';

const first = 'https://base.blockscout.com/api/v2/addresses/0x123/tokens?type=ERC-20';
const rows = (n, from = 0) => Array.from({ length: n }, (_, i) => from + i);

test('Blockscout pages are followed using its cursor and all rows are collected', async () => {
  const seen = [];
  const result = await collectTokenPages(first, async url => {
    seen.push(url);
    if (seen.length === 1) return { items: [{ id: 1 }], next_page_params: { items_count: 50, fiat_value: '1.25', id: 7 } };
    assert.equal(new URL(url).searchParams.get('items_count'), '50');
    assert.equal(new URL(url).searchParams.get('fiat_value'), '1.25');
    return { items: [{ id: 2 }], next_page_params: null };
  });
  assert.deepEqual(result, { items: [{ id: 1 }, { id: 2 }], complete: true, truncated: false });
  assert.equal(seen.length, 2);
});

test('a later page failure, timeout, malformed cursor or loop is incomplete, not truncated', async () => {
  const laterFailure = await collectTokenPages(first, async url => {
    if (url === first) return { items: [1], next_page_params: { page: 2 } };
    throw new Error('429');
  });
  assert.deepEqual(laterFailure, { items: [1], complete: false, truncated: false });
  const outOfTime = await collectTokenPages(first, async url => {
    if (url === first) return { items: [1], next_page_params: { page: 2 } };
    throw new Error('out of time');
  });
  assert.deepEqual(outOfTime, { items: [1], complete: false, truncated: false }, 'the time budget is not a cap: a retry can finish');
  await assert.rejects(collectTokenPages(first, async () => { throw new Error('down'); }), /down/);
  assert.deepEqual(await collectTokenPages(first, async () => ({ items: [1], next_page_params: { bad: {} } })), { items: [1], complete: false, truncated: false });
  assert.deepEqual(await collectTokenPages(first, async () => ({ items: [1], next_page_params: {} })), { items: [1], complete: false, truncated: false }, 'a cursor that leads back is a loop');
  assert.deepEqual(await collectTokenPages(first, async () => ({ items: [1], next_page_params: 'page-2' })), { items: [1], complete: false, truncated: false });
});

test('the page and row caps are deliberate: truncated, with every row read so far', async () => {
  assert.deepEqual(await collectTokenPages(first, async () => ({ items: [1], next_page_params: { page: 2 } }), 1), { items: [1], complete: false, truncated: true });
  const capped = await collectTokenPages(first, async () => ({ items: rows(MAX_TOKEN_ROWS + 1), next_page_params: null }));
  assert.equal(capped.items.length, MAX_TOKEN_ROWS);
  assert.deepEqual([capped.complete, capped.truncated], [false, true]);

  // Exactly at the cap with more to come: stops without asking for a page it would not use.
  let calls = 0;
  const full = await collectTokenPages(first, async () => {
    calls++;
    return { items: rows(50, calls * 50), next_page_params: { page: calls + 1 } };
  }, 10);
  assert.equal(calls, MAX_TOKEN_ROWS / 50);
  assert.deepEqual([full.items.length, full.complete, full.truncated], [MAX_TOKEN_ROWS, false, true]);

  // Exactly at the cap on the last page: complete.
  const exact = await collectTokenPages(first, async url => (url === first
    ? { items: rows(250), next_page_params: { page: 2 } }
    : { items: rows(50, 250), next_page_params: null }));
  assert.deepEqual([exact.items.length, exact.complete, exact.truncated], [MAX_TOKEN_ROWS, true, false]);
});
