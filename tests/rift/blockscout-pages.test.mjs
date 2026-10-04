import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectTokenPages } from '../../src/lib/rift/blockscout-pages.ts';

const first = 'https://base.blockscout.com/api/v2/addresses/0x123/tokens?type=ERC-20';

test('Blockscout pages are followed using its cursor and all rows are collected', async () => {
  const seen = [];
  const result = await collectTokenPages(first, async url => {
    seen.push(url);
    if (seen.length === 1) return { items: [{ id: 1 }], next_page_params: { items_count: 50, fiat_value: '1.25', id: 7 } };
    assert.equal(new URL(url).searchParams.get('items_count'), '50');
    assert.equal(new URL(url).searchParams.get('fiat_value'), '1.25');
    return { items: [{ id: 2 }], next_page_params: null };
  });
  assert.deepEqual(result, { items: [{ id: 1 }, { id: 2 }], complete: true });
  assert.equal(seen.length, 2);
});

test('a later page failure, malformed cursor, loop or page cap is reported as incomplete', async () => {
  const laterFailure = await collectTokenPages(first, async url => {
    if (url === first) return { items: [1], next_page_params: { page: 2 } };
    throw new Error('429');
  });
  assert.deepEqual(laterFailure, { items: [1], complete: false });
  await assert.rejects(collectTokenPages(first, async () => { throw new Error('down'); }), /down/);
  assert.deepEqual(await collectTokenPages(first, async () => ({ items: [1], next_page_params: { bad: {} } })), { items: [1], complete: false });
  assert.deepEqual(await collectTokenPages(first, async () => ({ items: [1], next_page_params: {} })), { items: [1], complete: false });
  assert.deepEqual(await collectTokenPages(first, async () => ({ items: [1], next_page_params: { page: 2 } }), 1), { items: [1], complete: false });
  const capped = await collectTokenPages(first, async () => ({ items: Array.from({ length: 301 }, (_, i) => i), next_page_params: null }));
  assert.equal(capped.items.length, 300);
  assert.equal(capped.complete, false);
});
